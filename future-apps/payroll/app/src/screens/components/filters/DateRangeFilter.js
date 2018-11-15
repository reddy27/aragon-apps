import React from 'react'
import PropTypes from 'prop-types'

import { isWithinInterval, startOfDay } from 'date-fns'

import { DropDown, Field } from '@aragon/ui'
import InlineField from '../../../components/Field/InlineField'
import Input from '../../../components/Input'


class DateRangeFilter extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      startDate: props.startDate,
      endDate: props.endDate
    }
  }

  handleStartDateChange = (date) => {
    const { onChange } = this.props
    const { startDate, endDate } = this.state
    this.setState({ startDate: date })
    onChange({ filter: salary => isWithinInterval(salary.date, { start: date, end: endDate }) })
  }

  handleEndDateChange = (date) => {
    const { onChange } = this.props
    const { startDate, endDate } = this.state
    this.setState({ endDate: date })
    onChange({ filter: salary => isWithinInterval(salary.date, { start: startDate, end: date }) })
  }

  render() {
    const { startDate, endDate } = this.state
    return (
      <InlineField label='Date Range:'>
        <Field style={{ margin: 0 }}>
          <Input.DateRange
            key="date-range-picker"
            startDate={startDate}
            endDate={endDate}
            onStartDateChange={this.handleStartDateChange}
            onEndDateChange={this.handleEndDateChange}
          />
        </Field>
      </InlineField>
    )
  }
}

DateRangeFilter.propTypes = {
  active: PropTypes.shape({
    filter: PropTypes.func
  }),
  endDate: PropTypes.string,
  onChange: PropTypes.func,
  startDate: PropTypes.string
}

DateRangeFilter.defaultProps = {
  startDate: startOfDay(new Date()),
  endDate: startOfDay(new Date())
}

export default DateRangeFilter
